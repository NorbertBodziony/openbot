import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ATTACHMENT_FILE_EXTENSIONS,
  IMAGE_ATTACHMENT_EXTENSIONS,
  isSupportedAttachmentName,
  SUPPORTED_ATTACHMENT_DESCRIPTION,
} from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
import {
  type AgentEvent,
  type AppInfo,
  type AppSetupState,
  type CentralAuthState,
  type ExternalDestination,
  type FilePreview,
  type ImportAttachmentsInput,
  IPC_CHANNELS,
  isSkillCategory,
  type MacPermissionId,
  type MacPermissionsState,
  type SendMessageInput,
  type SidebarLayoutSnapshot,
  type UpdateBotInput,
  type VoiceModelStatus,
  type VoiceTranscriptionResult,
} from "@openbot/contracts/ipc";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  Notification,
  autoUpdater as nativeAutoUpdater,
  type OpenDialogOptions,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";
import electronUpdater from "electron-updater";
import { z } from "zod";
import { AgentService } from "../backend/agent-service";
import { BotStore } from "../backend/bot-store";
import { BrowserHost } from "../backend/browser-host";
import { isCloseBrowserTabShortcut, isSelectAllShortcut, isToggleDevToolsShortcut } from "../backend/browser-shortcuts";
import { MailboxStore } from "../backend/mailbox-store";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TeamChatStore } from "../backend/team-chat-store";
import { AgentInitializationGate } from "./agent-initialization";
import { AgentMarketplaceService } from "./agent-marketplace-service";
import { notificationForAgentEvent } from "./agent-notifications";
import { HostAnalytics } from "./analytics";
import { readAnalyticsPreference, writeAnalyticsPreference } from "./analytics-preference-store";
import { readAppVariant, resolveAppIconPath } from "./app-icon";
import { CentralAuthManager, readCentralAuthApiUrl } from "./central-auth-manager";
import { resolveOpenBotCloudflaredExecutable } from "./cloudflared-artifact";
import { buildContentSecurityPolicy } from "./content-security-policy";
import {
  developmentUserDataName,
  readDevelopmentInstanceId,
  readDevelopmentProfile,
  shouldAutoStartHost,
  shouldShowDevelopmentWindow,
} from "./development-profile";
import { filePreviewFromBytes, localFilePreview, mimeTypeForName } from "./file-preview";
import { DEVELOPMENT_REMOTE_CLIENT_USERNAME, HostService } from "./host-service";
import {
  parseAgentRequest,
  parseApprovalResponse,
  parseBrowserTakeoverResponse,
  parseCancelQueuedMessage,
  parseChooseAttachments,
  parseCreateBot,
  parseCreateBotMemory,
  parseCreateRoutine,
  parseDeleteBotMemory,
  parseDeleteRoutine,
  parseImportAttachments,
  parseInterrupt,
  parseListRoutineRuns,
  parseMarkConversationRead,
  parseMessageReaction,
  parseOpenAttachment,
  parseOpenSharedFile,
  parseOpenWorkspaceFile,
  parsePromptResponse,
  parseReadConversationPage,
  parseReorderQueue,
  parseSearchConversationMessages,
  parseSendMessage,
  parseSetAgentAvatar,
  parseSidebarLayoutAction,
  parseSteerQueuedMessage,
  parseTestRoutine,
  parseUpdateBot,
  parseUpdateBotMemory,
  parseUpdateQueuedMessage,
  parseUpdateRoutine,
} from "./ipc/agent-inputs";
import {
  parseAnalyticsPreference,
  parseExternalDestination,
  parseMacPermission,
  parseProvider,
  parseProviderId,
} from "./ipc/app-inputs";
import { parseAvatarImage } from "./ipc/avatar-inputs";
import { parseBrowserNavigate, parseBrowserOpen, parseVisibility } from "./ipc/browser-inputs";
import { registerTeamIpcHandlers, withLocalHostSummary } from "./ipc/register-team-handlers";
import { isObject, requireString } from "./ipc/validation";
import { parseVoiceTranscription } from "./ipc/voice-inputs";
import { exportDiagnostics, exportOpenBotData } from "./maintenance-service";
import { ProviderRuntimeManager } from "./provider-runtime-manager";
import { RemoteDesktopManager } from "./remote-desktop-manager";
import { resolveRemoteDesktopRuntime } from "./remote-desktop-runtime-artifact";
import { loadOrCreateRemoteDesktopCredentials } from "./remote-desktop-secret-store";
import {
  type DevelopmentRemoteServerConnection,
  decodeAccountUsage,
  decodeAgentModelOptions,
  decodeAgentStatus,
  decodeBotMemories,
  decodeBotMemory,
  decodeBotSummaries,
  decodeBotSummary,
  decodeBrowserControlState,
  decodeBrowserTab,
  decodeBrowserTabs,
  decodeQueuedMessageReceipt,
  decodeQueueSnapshot,
  decodeRoutine,
  decodeRoutineRun,
  decodeRoutineRuns,
  decodeRoutines,
  decodeSidebarLayoutSnapshot,
  decodeVoid,
  RemoteServerManager,
} from "./remote-server-manager";
import { canCheckRendererPermission, canRequestRendererPermission } from "./renderer-permissions";
import { readSetupState, writeSetupState } from "./setup-store";
import { SkillMarketplaceService } from "./skill-marketplace-service";
import { TeamStore } from "./team-store";
import { handleTrusted } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";
import { supportsInstalledUpdates, UpdateService } from "./update-service";
import { WHISPER_MODEL_NAME, WHISPER_MODEL_URL } from "./voice-model-service";
import { VoiceTranscriptionService } from "./voice-transcription-service";

const commandLineUserDataDirectory = app.commandLine.getSwitchValue("user-data-dir").trim();
const developmentProfile = !app.isPackaged ? readDevelopmentProfile(process.env.OPENBOT_DEV_PROFILE) : null;
const developmentRemoteRole =
  !app.isPackaged &&
  (process.env.OPENBOT_DEV_REMOTE_ROLE === "host" || process.env.OPENBOT_DEV_REMOTE_ROLE === "client")
    ? process.env.OPENBOT_DEV_REMOTE_ROLE
    : null;
const developmentTestClientEnabled = !app.isPackaged && process.env.OPENBOT_DEV_TEST_CLIENT_ENABLED === "1";
const developmentInviteLinkOptions = {
  allowLocalDevelopmentApiUrl: developmentRemoteRole !== null,
};
if (!app.isPackaged && /^\d{4,5}$/u.test(process.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT ?? "")) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
if (commandLineUserDataDirectory) {
  app.setPath("userData", resolve(commandLineUserDataDirectory));
} else if (!app.isPackaged) {
  app.setPath(
    "userData",
    join(
      app.getPath("appData"),
      developmentUserDataName(
        developmentProfile ?? "app",
        readDevelopmentInstanceId(process.env.OPENBOT_DEV_INSTANCE_ID),
      ),
    ),
  );
}
app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId("app.openbot.desktop");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const appVariant = readAppVariant(process.env.OPENBOT_APP_VARIANT, app.isPackaged);
const appIconPath = resolveAppIconPath({
  variant: appVariant,
  platform: process.platform,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  sourceRoot: resolve(__dirname, "../.."),
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "openbot-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-remote-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-remote-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-remote-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let agentService: AgentService | null = null;
let mailboxStore: MailboxStore | null = null;
let updateService: UpdateService | null = null;
let providerRuntimeManager: ProviderRuntimeManager | null = null;
let hostService: HostService | null = null;
let remoteDesktopManager: RemoteDesktopManager | null = null;
let remoteServerManager: RemoteServerManager | null = null;
let centralAuthManager: CentralAuthManager | null = null;
let hostAnalytics: HostAnalytics | null = null;
let voiceTranscriptionService: VoiceTranscriptionService | null = null;
let isQuitting = false;
let shutdownStarted = false;
let systemSessionEnding = false;
let pendingInviteUrl: string | null = findInviteUrl(process.argv);
let inviteReceiverReady = false;

const SETUP_FILE = "openbot-setup-v2.json";
const ANALYTICS_PREFERENCE_FILE = "openbot-analytics-preference-v1.json";
const BROWSER_STATE_FILE = "openbot-browser-state-v1.json";
const SIDEBAR_LAYOUT_FILE = "openbot-sidebar-layout-v1.json";
const TEAM_FILE = "openbot-team-server-v1.json";
const REMOTE_SERVERS_FILE = "openbot-remote-servers-v1.json";
const CENTRAL_AUTH_FILE = "openbot-central-auth-v1.bin";
const LEGACY_REMOTE_DESKTOP_CREDENTIAL_FILE = "openbot-remote-desktop-credential-v1.json";
const REMOTE_DESKTOP_RUNTIME_SECRET_FILE = "openbot-remote-desktop-runtime-v1.json";

const EXTERNAL_DESTINATIONS: Record<ExternalDestination, string> = {
  "agent-setup": "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  "claude-install": "https://code.claude.com/docs",
  "claude-sign-in": "https://code.claude.com/docs/en/authentication",
  feedback: "https://x.com/intent/post?text=Feedback%20for%20OpenBot%20%40norbertbodziony%3A%20",
  message: "https://x.com/norbertbodziony",
};

function configureContentSecurityPolicy(): void {
  const policy = buildContentSecurityPolicy(app.isPackaged);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame" || !isTrustedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

function registerIpcHandlers(
  service: AgentService,
  providerRuntimes: ProviderRuntimeManager,
  mailbox: MailboxStore,
  browser: BrowserHost,
  updater: UpdateService,
  setupFile: string,
  analyticsPreferenceFile: string,
  initializeAgent: () => Promise<void>,
  sidebarLayout: SidebarLayoutStore,
  host: HostService,
  remoteDesktop: RemoteDesktopManager,
  remoteServers: RemoteServerManager,
  centralAuth: CentralAuthManager,
  skills: SkillMarketplaceService,
  marketplaceAgents: AgentMarketplaceService,
  voice: VoiceTranscriptionService,
): void {
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
  handleTrusted(IPC_CHANNELS.saveSetup, async (input: unknown): Promise<AppSetupState> => {
    const preferredProvider = parseProvider(input);
    const state = await writeSetupState(setupFile, preferredProvider);
    await service.setPreferredProvider(preferredProvider);
    await initializeAgent();
    return state;
  });
  handleTrusted(IPC_CHANNELS.getMacPermissions, readMacPermissions);
  handleTrusted(IPC_CHANNELS.requestMacPermission, (permission: unknown) =>
    requestMacPermission(parseMacPermission(permission)),
  );
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
  handleTrusted(IPC_CHANNELS.voiceGetModelStatus, (): Promise<VoiceModelStatus> => voice.getModelStatus());
  handleTrusted(IPC_CHANNELS.voicePrepareModel, (): Promise<VoiceModelStatus> => voice.prepareModel());
  handleTrusted(
    IPC_CHANNELS.voiceTranscribe,
    (input: unknown): Promise<VoiceTranscriptionResult> => voice.transcribe(parseVoiceTranscription(input).audio),
  );
  handleTrusted(IPC_CHANNELS.authGetState, () => centralAuth.getState());
  handleTrusted(IPC_CHANNELS.authRetry, () => centralAuth.retry());
  handleTrusted(IPC_CHANNELS.authRequestEmailCode, (email: unknown) =>
    centralAuth.requestEmailCode(requireString(email, "email", INPUT_LIMITS.email)),
  );
  handleTrusted(IPC_CHANNELS.authVerifyEmailCode, (input: unknown) => {
    if (!isObject(input)) throw new Error("Sign-in code details are required.");
    return centralAuth.verifyEmailCode(
      requireString(input.challengeId, "challengeId", INPUT_LIMITS.identifier),
      requireString(input.code, "code", 32),
    );
  });
  handleTrusted(IPC_CHANNELS.authUpdateAvatar, (input: unknown) => centralAuth.updateAvatar(parseAvatarImage(input)));
  handleTrusted(IPC_CHANNELS.authLogout, () => centralAuth.logout());
  handleTrusted(IPC_CHANNELS.skillsList, (input: unknown) => {
    if (input === null || input === undefined) return skills.list();
    if (!isObject(input)) throw new Error("Invalid marketplace query.");
    const category = input.category;
    if (category !== undefined && !isSkillCategory(category)) throw new Error("Unknown skill category.");
    if (input.sort !== undefined && input.sort !== "installs") throw new Error("Unknown skill sort order.");
    return skills.list({
      ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
      ...(category ? { category } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
      ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
      ...(isNumber(input.limit) ? { limit: input.limit } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsGet, (input: unknown) => skills.get(requireString(input, "skillId")));
  handleTrusted(IPC_CHANNELS.skillsListMine, () => skills.listMine());
  handleTrusted(IPC_CHANNELS.skillsChoosePackage, async () => {
    const options: OpenDialogOptions = {
      title: "Choose a skill folder or ZIP",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Skill packages", extensions: ["zip"] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : skills.stage(result.filePaths[0]);
  });
  handleTrusted(IPC_CHANNELS.skillsSubmit, (input: unknown) => {
    if (!isObject(input) || !isSkillCategory(input.category)) throw new Error("Invalid skill submission.");
    return skills.submit({
      draftId: requireString(input.draftId, "draftId"),
      category: input.category,
      icon: parseAvatarImage(input.icon),
      ...(input.skillId === undefined ? {} : { skillId: requireString(input.skillId, "skillId") }),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsListInstalled, (input: unknown) =>
    skills.listInstalled(requireString(input, "botId")),
  );
  handleTrusted(IPC_CHANNELS.skillsInstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid skill installation.");
    return skills.install({
      botId: requireString(input.botId, "botId"),
      skillId: requireString(input.skillId, "skillId"),
      ...(input.replaceModified === true ? { replaceModified: true } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsUninstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid skill removal.");
    return skills.uninstall({
      botId: requireString(input.botId, "botId"),
      skillId: requireString(input.skillId, "skillId"),
      ...(input.removeModified === true ? { removeModified: true } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsList, (input: unknown) => {
    if (input === null || input === undefined) return marketplaceAgents.list();
    if (!isObject(input)) throw new Error("Invalid agent marketplace query.");
    if (input.sort !== undefined && input.sort !== "installs") throw new Error("Unknown agent sort order.");
    return marketplaceAgents.list({
      ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
      ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
      ...(isNumber(input.limit) ? { limit: input.limit } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsGet, (input: unknown) =>
    marketplaceAgents.get(requireString(input, "agentId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsListMine, () => marketplaceAgents.listMine());
  handleTrusted(IPC_CHANNELS.marketplaceAgentsPreview, (input: unknown) =>
    marketplaceAgents.preview(requireString(input, "botId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsSubmit, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent submission.");
    return marketplaceAgents.submit({
      botId: requireString(input.botId, "botId"),
      ...(input.agentId === undefined ? {} : { agentId: requireString(input.agentId, "agentId") }),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsInstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent installation.");
    return marketplaceAgents.install({
      agentId: requireString(input.agentId, "agentId"),
      ...(input.botId === undefined ? {} : { botId: requireString(input.botId, "botId", INPUT_LIMITS.identifier) }),
      timezone: requireString(input.timezone, "timezone", 255),
      receiptId: requireString(input.receiptId, "receiptId", INPUT_LIMITS.identifier),
    });
  });
  handleTrusted(IPC_CHANNELS.updateGetStatus, () => updater.getStatus());
  handleTrusted(IPC_CHANNELS.updateCheck, () => updater.checkForUpdates());
  handleTrusted(IPC_CHANNELS.updateDownload, () => updater.downloadUpdate());
  handleTrusted(IPC_CHANNELS.updateInstall, () => updater.installUpdate());
  handleTrusted(IPC_CHANNELS.maintenanceExportData, () =>
    exportOpenBotData({ service, mailbox, parentWindow: mainWindow }),
  );
  handleTrusted(IPC_CHANNELS.maintenanceExportDiagnostics, () =>
    exportDiagnostics({ service, browser, updater, parentWindow: mainWindow }),
  );

  registerTeamIpcHandlers({
    host,
    remoteDesktop,
    remoteServers,
    takePendingInvite: () => {
      inviteReceiverReady = true;
      const inviteUrl = pendingInviteUrl;
      pendingInviteUrl = null;
      return inviteUrl;
    },
  });

  handleTrusted(IPC_CHANNELS.agentGetStatus, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getStatus()
      : remoteServers.request("/v1/agents/status", {}, serverId, decodeAgentStatus);
  });
  handleTrusted(IPC_CHANNELS.agentGetUsage, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getUsage()
      : remoteServers.request("/v1/agents/usage", {}, serverId, decodeAccountUsage);
  });
  handleTrusted(IPC_CHANNELS.agentListModels, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listModels()
      : remoteServers.request("/v1/agents/models", {}, serverId, decodeAgentModelOptions);
  });
  handleTrusted(IPC_CHANNELS.agentListBots, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listBots()
      : remoteServers.request("/v1/agents", {}, serverId, decodeBotSummaries);
  });
  handleTrusted(IPC_CHANNELS.agentGetSidebarLayout, (input: unknown): Promise<SidebarLayoutSnapshot> => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? Promise.resolve(sidebarLayout.getSnapshot())
      : remoteServers.request("/v1/sidebar-layout", {}, serverId, decodeSidebarLayoutSnapshot);
  });
  handleTrusted(IPC_CHANNELS.agentMutateSidebarLayout, (input: unknown): Promise<SidebarLayoutSnapshot> => {
    const scoped = parseAgentRequest(input);
    const action = parseSidebarLayoutAction(scoped.payload);
    return scoped.serverId === "local"
      ? sidebarLayout.mutate(action, new Set(service.listBots().map((bot) => bot.id)))
      : remoteServers.request(
          "/v1/sidebar-layout/actions",
          { method: "POST", body: action },
          scoped.serverId,
          decodeSidebarLayoutSnapshot,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateBot, (input: unknown) => {
    const { serverId, payload } = parseAgentRequest(input);
    const parsed = parseCreateBot(payload);
    return serverId === "local"
      ? service.createBot(parsed)
      : remoteServers.request("/v1/agents", { method: "POST", body: parsed }, serverId, decodeBotSummary);
  });
  handleTrusted(IPC_CHANNELS.agentUpdateBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeUpdateBot(service, remoteServers, scoped.serverId, parseUpdateBot(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetAvatar, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSetAgentAvatar(scoped.payload);
    return scoped.serverId === "local"
      ? service.setAvatar(parsed.botId, parsed.image)
      : remoteServers.setAgentAvatar(parsed.botId, parsed.image, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentDeleteBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId");
    return routeDeleteBot(service, sidebarLayout, remoteServers, scoped.serverId, botId);
  });
  handleTrusted(IPC_CHANNELS.agentListMemories, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listMemories(botId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(botId)}/memories`,
          {},
          scoped.serverId,
          decodeBotMemories,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCreateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.createMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories`,
          { method: "POST", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
          { method: "PATCH", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseDeleteBotMemory(scoped.payload);
    if (scoped.serverId === "local") return service.deleteMemory(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentClearMemories, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    if (scoped.serverId === "local") return service.clearMemories(botId);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(botId)}/memories`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentListRoutines, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listRoutines(botId)
      : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/routines`, {}, scoped.serverId, decodeRoutines);
  });
  handleTrusted(IPC_CHANNELS.agentCreateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCreateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.createRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines`,
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
          { method: "PATCH", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseDeleteRoutine(scoped.payload);
    if (scoped.serverId === "local") return service.deleteRoutine(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentTestRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseTestRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.testRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/test`,
          { method: "POST" },
          scoped.serverId,
          decodeRoutineRun,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListRoutineRuns, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseListRoutineRuns(scoped.payload);
    return scoped.serverId === "local"
      ? service.listRoutineRuns(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/runs?limit=${parsed.limit}`,
          {},
          scoped.serverId,
          decodeRoutineRuns,
        );
  });
  handleTrusted(IPC_CHANNELS.agentReadConversation, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeReadConversation(host, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentReadConversationPage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseReadConversationPage(scoped.payload);
    return scoped.serverId === "local"
      ? host.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit)
      : remoteServers.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSearchConversationMessages, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSearchConversationMessages(scoped.payload);
    return scoped.serverId === "local"
      ? host.searchAgentConversationMessages(parsed.query, parsed.botId, parsed.cursor, parsed.limit)
      : remoteServers.searchAgentConversationMessages(
          parsed.query,
          parsed.botId,
          parsed.cursor,
          parsed.limit,
          scoped.serverId,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListConversationReads, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? host.listAgentConversationReads()
      : remoteServers.listAgentConversationReads(serverId);
  });
  handleTrusted(IPC_CHANNELS.agentMarkConversationRead, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseMarkConversationRead(scoped.payload);
    return scoped.serverId === "local"
      ? host.markAgentConversationRead(parsed)
      : remoteServers.markAgentConversationRead(parsed, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSendMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeSendMessage(service, remoteServers, scoped.serverId, parseSendMessage(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetMessageReaction, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseMessageReaction(scoped.payload);
    return scoped.serverId === "local"
      ? service.setMessageReaction(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/reactions`,
          {
            method: "POST",
            body: parsed,
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, async (input: unknown) => {
    const { serverId, payload } = parseAgentRequest(input);
    const { filter } = parseChooseAttachments(payload);
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters:
        filter === "images"
          ? [{ name: "Images", extensions: [...IMAGE_ATTACHMENT_EXTENSIONS] }]
          : [{ name: "Supported files", extensions: [...ATTACHMENT_FILE_EXTENSIONS] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    if (serverId === "local") return service.prepareAttachments(result.filePaths);
    return uploadRemotePaths(remoteServers, serverId, result.filePaths);
  });
  handleTrusted(IPC_CHANNELS.agentImportAttachments, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseImportAttachments(scoped.payload);
    return scoped.serverId === "local"
      ? service.prepareImportedAttachments(parsed.paths, parsed.data)
      : uploadRemoteImports(remoteServers, scoped.serverId, parsed);
  });
  handleTrusted(IPC_CHANNELS.agentDiscardDraftAttachment, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const attachmentId = requireString(scoped.payload, "attachmentId");
    return scoped.serverId === "local"
      ? service.discardDraftAttachment(attachmentId)
      : remoteServers.request(
          `/v1/attachments/${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenAttachment(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadAttachment(parsed.attachmentId, scoped.serverId);
      const suggestedName = basename(downloaded.name) || `attachment-${parsed.attachmentId}`;
      if (parsed.action === "download") {
        const extension = extname(suggestedName).slice(1).toLowerCase();
        const saveOptions: Electron.SaveDialogOptions = {
          defaultPath: join(app.getPath("downloads"), suggestedName),
          filters: [{ name: "Attachment", extensions: extension ? [extension] : ["*"] }],
          showsTagField: false,
        };
        const result =
          mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, saveOptions)
            : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) return;
        await writeFile(result.filePath, downloaded.bytes, { mode: 0o600 });
        return;
      }
      const cacheRoot = join(app.getPath("userData"), "remote-attachments");
      await mkdir(cacheRoot, { recursive: true });
      const safeName = `${parsed.attachmentId}-${suggestedName}`;
      const target = join(cacheRoot, safeName);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      if (parsed.action === "reveal") shell.showItemInFolder(target);
      else {
        const openError = await shell.openPath(target);
        if (openError) throw new Error(openError);
      }
      return;
    }
    const attachment = await mailbox.resolveAttachment(parsed.attachmentId);
    if (!attachment) throw new Error("Attachment was not found.");
    if (parsed.action === "download") {
      const safeId = basename(parsed.attachmentId).replace(/[^a-z0-9_-]/gi, "-") || "attachment";
      const mimeExtension = attachment.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
      const suggestedName = `attachment-${safeId}${mimeExtension ? `.${mimeExtension}` : ""}`;
      const extension = extname(suggestedName).slice(1).toLowerCase();
      const saveOptions: Electron.SaveDialogOptions = {
        defaultPath: join(app.getPath("downloads"), suggestedName),
        filters: [{ name: "Attachment", extensions: extension ? [extension] : ["*"] }],
        showsTagField: false,
      };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) return;
      await copyFile(attachment.path, result.filePath);
      return;
    }
    if (parsed.action === "reveal") {
      shell.showItemInFolder(attachment.path);
      return;
    }
    const error = await shell.openPath(attachment.path);
    if (error) throw new Error(error);
  });
  handleTrusted(IPC_CHANNELS.agentOpenSharedFile, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenSharedFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadSharedFile(parsed.path, scoped.serverId);
      const cacheRoot = join(app.getPath("userData"), "remote-shared-files");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const cacheKey = createHash("sha256").update(`${scoped.serverId}:${parsed.path}`).digest("hex");
      const target = join(cacheRoot, `${cacheKey}-${basename(downloaded.name)}`);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      await chmod(target, 0o600);
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
      return;
    }
    const sharedFile = await service.resolveSharedFile(parsed.path);
    const openError = await shell.openPath(sharedFile.path);
    if (openError) throw new Error(openError);
  });
  handleTrusted(IPC_CHANNELS.agentOpenWorkspaceFile, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, scoped.serverId);
      const cacheRoot = join(app.getPath("userData"), "remote-workspace-files");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const cacheKey = createHash("sha256").update(`${scoped.serverId}:${parsed.botId}:${parsed.path}`).digest("hex");
      const target = join(cacheRoot, `${cacheKey}-${basename(downloaded.name)}`);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      await chmod(target, 0o600);
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
      return;
    }
    const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
    const openError = await shell.openPath(workspaceFile.path);
    if (openError) throw new Error(openError);
  });
  handleTrusted(IPC_CHANNELS.agentPreviewSharedFile, async (input: unknown): Promise<FilePreview> => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenSharedFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadSharedFile(parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const sharedFile = await service.resolveSharedFile(parsed.path);
    return localFilePreview(sharedFile.path, sharedFile.name, sharedFile.size);
  });
  handleTrusted(IPC_CHANNELS.agentPreviewWorkspaceFile, async (input: unknown): Promise<FilePreview> => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
    return localFilePreview(workspaceFile.path, workspaceFile.name, workspaceFile.size);
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeListQueue(service, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCancelQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.cancelQueuedMessage(parsed.botId, parsed.deliveryId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/cancel`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentSteerQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSteerQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.steerQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/steer`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId, expectedTurnId: parsed.expectedTurnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/update`,
          {
            method: "POST",
            body: {
              deliveryId: parsed.deliveryId,
              text: parsed.text,
              keepAttachmentIds: parsed.keepAttachmentIds,
              attachmentDraftIds: parsed.attachmentDraftIds,
            },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentReorderQueue, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseReorderQueue(scoped.payload);
    return scoped.serverId === "local"
      ? service.reorderQueue(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/reorder`,
          { method: "POST", body: { deliveryIds: parsed.deliveryIds } },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseInterrupt(scoped.payload);
    return scoped.serverId === "local"
      ? service.interrupt(parsed.botId, parsed.turnId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/interrupt`,
          {
            method: "POST",
            body: { turnId: parsed.turnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parsePromptResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToPrompt(parsed)
      : remoteServers.request("/v1/prompts/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToApproval, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseApprovalResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToApproval(parsed)
      : remoteServers.request("/v1/approvals/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToBrowserTakeover, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseBrowserTakeoverResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToBrowserTakeover(parsed)
      : remoteServers.request(
          "/v1/browser-takeovers/respond",
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeVoid,
        );
  });

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
  handleTrusted(IPC_CHANNELS.browserGetControlState, () =>
    remoteServers.activeServerId === "local"
      ? browser.getControlState()
      : remoteServers.request("/v1/browser/control", {}, undefined, decodeBrowserControlState),
  );
  handleTrusted(IPC_CHANNELS.browserSetVisible, async (input: unknown) => {
    const parsed = parseVisibility(input);
    if (remoteServers.activeServerId === "local") await browser.setVisible(parsed);
    else {
      await remoteServers.request("/v1/browser/visible", { method: "POST", body: parsed }, undefined, decodeVoid);
    }
  });
}

function createWindow(): BrowserWindow {
  let inspectElementModifierPressed = false;
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d0e",
    title: developmentProfile === "test-client" ? "OpenBot Local Client" : "OpenBot Local Host",
    icon: appIconPath,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 8, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      devTools: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => {
    if (
      shouldShowDevelopmentWindow({
        remoteRole: developmentRemoteRole,
        testClientEnabled: developmentTestClientEnabled,
      })
    ) {
      window.show();
    }
  });
  window.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  if (process.platform === "win32") {
    window.on("query-session-end", () => {
      systemSessionEnding = true;
      isQuitting = true;
      void providerRuntimeManager?.stop();
    });
    window.on("session-end", () => {
      systemSessionEnding = true;
      isQuitting = true;
      void providerRuntimeManager?.stop();
    });
  }
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key.toLowerCase() === "shift") {
      inspectElementModifierPressed = input.type === "keyDown";
    }
    if (isToggleDevToolsShortcut(input)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
      return;
    }
    if (isSelectAllShortcut(input)) {
      event.preventDefault();
      void window.webContents.executeJavaScript(
        `(() => {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
            active.select();
            return;
          }
          if (!(active instanceof HTMLElement) || !active.isContentEditable) return;
          const range = document.createRange();
          range.selectNodeContents(active);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        })()`,
        true,
      );
      return;
    }
    const tabId = browserHost?.activeTabId;
    if (!browserHost?.visible || !tabId || !isCloseBrowserTabShortcut(input)) return;
    event.preventDefault();
    setImmediate(() => void browserHost?.close(tabId).catch(() => undefined));
  });
  window.webContents.on("context-menu", (event, params) => {
    if (!inspectElementModifierPressed) return;
    event.preventDefault();
    window.webContents.inspectElement(params.x, params.y);
  });
  window.on("blur", () => {
    inspectElementModifierPressed = false;
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });

  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  inviteReceiverReady = false;
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl ? window.loadURL(developmentUrl) : window.loadURL("openbot-app://app/index.html");
}

function configureApplicationMenu(service: AgentService, updater: UpdateService): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          {
            label: "Stop all agents",
            accelerator: "CommandOrControl+.",
            click: () => void service.interruptAll(),
          },
          { type: "separator" },
          {
            label: "Check for Updates…",
            click: () => void updater.checkForUpdates(),
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function forwardAgentEvent(serverId: string, event: AgentEvent): void {
  if (serverId === "local") hostAnalytics?.handleAgentEvent(event);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.agentEvent, { serverId, event });
  if (mainWindow.isFocused() || !Notification.isSupported()) return;

  const content = notificationForAgentEvent(event, agentService?.listBots() ?? []);
  if (!content) return;
  const notification = new Notification(content);
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

function forwardUpdateStatus(status: import("@openbot/contracts/ipc").UpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.updateEvent, status);
}

function forwardVoiceModelStatus(status: VoiceModelStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.voiceModelStatus, status);
}

function forwardProviderRuntimeStatus(snapshot: import("@openbot/contracts/ipc").ProviderRuntimeSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.providerRuntimesEvent, snapshot);
}

function forwardHostStatus(status: import("@openbot/contracts/ipc").HostStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.hostEvent, status);
  if (remoteServerManager) {
    mainWindow.webContents.send(IPC_CHANNELS.serversEvent, withLocalHostSummary(remoteServerManager.list(), status));
  }
}

function forwardRemoteDesktopSessions(sessions: import("@openbot/contracts/ipc").RemoteDesktopSession[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.remoteDesktopEvent, sessions);
}

function forwardServers(servers: import("@openbot/contracts/ipc").ServerSummary[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.serversEvent,
    hostService ? withLocalHostSummary(servers, hostService.getStatus()) : servers,
  );
}

function forwardTeamPresence(serverId: string, snapshot: import("@openbot/contracts/ipc").TeamPresenceSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.serversPresence, { serverId, snapshot });
}

function forwardDirectMessage(
  serverId: string,
  event: import("@openbot/contracts/ipc").DirectMessageRealtimeEvent,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.serversDirectMessage, { serverId, event });
}

function forwardDirectTyping(
  serverId: string,
  event: import("@openbot/contracts/ipc").DirectTypingRealtimeEvent,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.serversDirectTyping, { serverId, event });
}

function forwardCentralAuth(state: CentralAuthState): void {
  if (state.status === "signed_in") {
    const host = hostService;
    if (host) {
      void host
        .syncSignedInAccount(state.user)
        .then(async () => {
          hostAnalytics?.flushPending();
          const status = host.getStatus();
          if (shouldAutoStartHost(status)) await host.start();
        })
        .catch((error) => {
          console.error("Unable to synchronize or republish this OpenBot:", error);
        });
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.authEvent, state);
}

function acceptInviteUrl(value: string): void {
  try {
    parseInviteUrl(value, developmentInviteLinkOptions);
  } catch {
    return;
  }
  pendingInviteUrl = value;
  if (mainWindow && !mainWindow.isDestroyed() && inviteReceiverReady) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC_CHANNELS.serversInvite, value);
    pendingInviteUrl = null;
  }
}

function acceptOpenbotUrl(value: string): void {
  acceptInviteUrl(value);
}

function findInviteUrl(values: string[]): string | null {
  for (const value of values) {
    try {
      parseInviteUrl(value, developmentInviteLinkOptions);
      return value;
    } catch {
      // Most command-line arguments are not invitations.
    }
  }
  return null;
}

app.on("open-url", (event, url) => {
  try {
    parseInviteUrl(url, developmentInviteLinkOptions);
  } catch {
    return;
  }
  event.preventDefault();
  acceptOpenbotUrl(url);
});

app.on("continue-activity", (event, type, _userInfo, details) => {
  if (type !== "NSUserActivityTypeBrowsingWeb" || !details.webpageURL) return;
  try {
    parseInviteUrl(details.webpageURL, developmentInviteLinkOptions);
  } catch {
    return;
  }
  event.preventDefault();
  acceptInviteUrl(details.webpageURL);
});

if (!hasSingleInstanceLock) {
  // No application services exist yet, so the secondary process can exit without shutdown work.
  process.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = findInviteUrl(argv);
    if (deepLink) acceptOpenbotUrl(deepLink);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin") app.setAsDefaultProtocolClient("openbot");
      if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
      configureContentSecurityPolicy();
      configureRendererPermissions();
      mainWindow = createWindow();
      centralAuthManager = new CentralAuthManager({
        apiUrl: readCentralAuthApiUrl(
          process.env.OPENBOT_AUTH_API_URL,
          app.isPackaged ? "https://api.openbot.run" : "http://127.0.0.1:3100",
        ),
        storagePath: join(app.getPath("userData"), CENTRAL_AUTH_FILE),
        canPersist: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("macOS secure storage is unavailable.");
          }
          return safeStorage.encryptString(value);
        },
        decrypt: (value) => safeStorage.decryptString(value),
      });
      centralAuthManager.on("changed", forwardCentralAuth);
      const centralAuthInitialization = centralAuthManager.initialize();
      const store = new BotStore(app.getPath("userData"), homedir());
      await store.initialize();
      const sidebarLayoutStore = new SidebarLayoutStore(join(app.getPath("userData"), SIDEBAR_LAYOUT_FILE));
      await sidebarLayoutStore.initialize();
      await sidebarLayoutStore.reconcileAgents(new Set(store.list().map((bot) => bot.id)));
      mailboxStore = new MailboxStore(app.getPath("userData"), store.sharedRoot, store.database);
      await mailboxStore.initialize();
      configureApplicationProtocol();
      browserHost = new BrowserHost(mainWindow, store.downloadsRoot, join(app.getPath("userData"), BROWSER_STATE_FILE));
      await browserHost.restore();
      const setupFile = join(app.getPath("userData"), SETUP_FILE);
      const analyticsPreferenceFile = join(app.getPath("userData"), ANALYTICS_PREFERENCE_FILE);
      const setupState = await readSetupState(setupFile);
      const analyticsPreference = await readAnalyticsPreference(analyticsPreferenceFile);
      providerRuntimeManager = new ProviderRuntimeManager({
        root: join(app.getPath("userData"), "provider-runtimes"),
      });
      await providerRuntimeManager.initialize();
      agentService = new AgentService(
        store,
        mailboxStore,
        browserHost,
        readComputerUsePrerequisites,
        30_000,
        setupState.preferredProvider ?? "codex",
        null,
        providerRuntimeManager.executablePath("codex"),
        providerRuntimeManager.executablePath("claude"),
        providerRuntimeManager.executablePath("grok"),
      );
      const service = agentService;
      providerRuntimeManager.on("status", forwardProviderRuntimeStatus);
      providerRuntimeManager.on("ready", (provider) => {
        void service.refreshProvider(provider).catch((error) => {
          console.error(`Unable to refresh ${provider} after runtime installation:`, error);
        });
      });
      const skillMarketplace = new SkillMarketplaceService(
        centralAuthManager,
        () => service.listBots(),
        async (botId) => service.refreshBotRuntime(botId),
      );
      const agentMarketplace = new AgentMarketplaceService(centralAuthManager, service, skillMarketplace);
      configureAttachmentProtocol(mailboxStore, service);
      const teamStore = new TeamStore(join(app.getPath("userData"), TEAM_FILE));
      await teamStore.initialize();
      if (developmentRemoteRole) {
        const email =
          developmentRemoteRole === "host"
            ? (teamStore.getOwnerEmail() ?? "openbot-dev-host@example.com")
            : "openbot-dev-client@example.com";
        const user = await ensureDevelopmentAccount(centralAuthManager, email);
        if (developmentRemoteRole === "host" && !teamStore.configured) {
          await teamStore.configureWithAccount("OpenBot Local Dev Host", user);
        }
        if (developmentRemoteRole === "client" && !setupState.completed) {
          await writeSetupState(setupFile, "codex");
        }
      }
      if (developmentRemoteRole === "host" && !developmentTestClientEnabled) {
        const technicalMember = teamStore
          .listMembers()
          .find((member) => member.username === DEVELOPMENT_REMOTE_CLIENT_USERNAME);
        if (technicalMember && technicalMember.role !== "owner") {
          await teamStore.removeMember(technicalMember.id);
        }
      }
      const teamChatStore = new TeamChatStore(store.database);
      const remoteDesktopRuntime = await resolveRemoteDesktopRuntime({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        sourceRoot: resolve(__dirname, "../.."),
        platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
        architecture: process.arch,
        overrideRoot: process.env.OPENBOT_REMOTE_DESKTOP_RUNTIME_PATH,
      });
      hostService = new HostService({
        store: teamStore,
        agents: service,
        sidebarLayout: sidebarLayoutStore,
        mailbox: mailboxStore,
        browser: browserHost,
        chat: teamChatStore,
        allowLocalDevelopmentInvites: developmentRemoteRole === "host",
        logDirectory: join(app.getPath("userData"), "logs", "remote"),
        removeLegacyRemoteDesktopCredential: async () => {
          const credentialPath = join(app.getPath("userData"), LEGACY_REMOTE_DESKTOP_CREDENTIAL_FILE);
          await Promise.all([rm(credentialPath, { force: true }), rm(`${credentialPath}.tmp`, { force: true })]);
        },
        getSignedInUser: () => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.getSignedInUser();
        },
        redeemCentralTicket: (ticket, serverId) => {
          if (!centralAuthManager) return Promise.resolve(null);
          return centralAuthManager.redeemTeamAuthTicket(ticket, serverId);
        },
        sendTeamInviteEmail: (input) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.sendTeamInviteEmail(input);
        },
        platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
        unattended: false,
        resolveCloudflared: () =>
          resolveOpenBotCloudflaredExecutable({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            sourceRoot: resolve(__dirname, "../.."),
            overridePath: process.env.OPENBOT_CLOUDFLARED_PATH,
          }),
        remoteDesktopRuntimePaths: remoteDesktopRuntime,
        remoteDesktopStateDirectory: join(app.getPath("userData"), "remote-desktop-runtime"),
        getRemoteDesktopRuntimeCredentials: () => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error("System secret storage is unavailable.");
          return loadOrCreateRemoteDesktopCredentials(
            join(app.getPath("userData"), REMOTE_DESKTOP_RUNTIME_SECRET_FILE),
            {
              encrypt: (value) => safeStorage.encryptString(value),
              decrypt: (value) => safeStorage.decryptString(value),
            },
          );
        },
        getRemoteDesktopDisplays: () => {
          const primaryId = screen.getPrimaryDisplay().id;
          return screen.getAllDisplays().map((display, index) => ({
            id: String(display.id),
            label: display.label || `Display ${index + 1}`,
            width: display.size.width,
            height: display.size.height,
            primary: display.id === primaryId,
          }));
        },
        getRemoteDesktopIceServers: () => {
          if (developmentRemoteRole === "host") return Promise.resolve([]);
          const identity = teamStore.getIdentity();
          if (!identity || !centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.getTeamHostIceServers(identity.serverId);
        },
        provisionTeamTunnel: (input) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.provisionTeamTunnel(input);
        },
      });
      const signedInState = centralAuthManager.getState();
      if (signedInState.status === "signed_in") {
        await hostService.syncSignedInAccount(signedInState.user);
      }
      const analyticsPlatform = process.platform;
      if (analyticsPlatform !== "darwin" && analyticsPlatform !== "win32" && analyticsPlatform !== "linux") {
        throw new Error(`Unsupported analytics platform: ${analyticsPlatform}`);
      }
      hostAnalytics = new HostAnalytics({
        enabled: app.isPackaged && appVariant === "production",
        trackingEnabled: analyticsPreference.enabled,
        appVersion: app.getVersion(),
        platform: analyticsPlatform,
        resolveOwner: () => {
          const storedOwner = teamStore.getOwnerAnalyticsIdentity();
          if (storedOwner) return storedOwner;
          const state = centralAuthManager?.getState();
          if (state?.status !== "signed_in") return null;
          const ownerEmail = teamStore.getOwnerEmail();
          return !teamStore.configured || ownerEmail?.trim().toLowerCase() === state.user.email.trim().toLowerCase()
            ? state.user
            : null;
        },
        resolveBot: (botId) => service.listBots().find((bot) => bot.id === botId) ?? null,
      });
      hostAnalytics.flushPending();
      remoteServerManager = new RemoteServerManager(
        join(app.getPath("userData"), REMOTE_SERVERS_FILE),
        {
          encrypt: (value) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error("macOS secure storage is unavailable.");
            }
            return safeStorage.encryptString(value);
          },
          decrypt: (value) => safeStorage.decryptString(value),
        },
        {
          createTeamAuthTicket: (serverId) => {
            if (!centralAuthManager) throw new Error("The account service is not ready.");
            return centralAuthManager.createTeamAuthTicket(serverId);
          },
          getEmail: () => {
            if (!centralAuthManager) throw new Error("The account service is not ready.");
            return centralAuthManager.getSignedInUser().email;
          },
        },
        { allowLocalDevelopmentInvites: developmentRemoteRole !== null },
      );
      await remoteServerManager.initialize();
      if (developmentRemoteRole === "host") {
        await rm(developmentRemoteConnectionPath(), { force: true });
        await hostService.startDevelopmentLocal();
        if (developmentTestClientEnabled) {
          await writeDevelopmentRemoteConnection(await hostService.createDevelopmentConnection());
        }
      } else if (developmentRemoteRole === "client") {
        await connectDevelopmentRemoteServer(remoteServerManager);
      }
      configureServerLogoProtocols(teamStore);
      remoteDesktopManager = new RemoteDesktopManager(remoteServerManager);
      const host = hostService;
      const remoteDesktop = remoteDesktopManager;
      const remoteServers = remoteServerManager;
      voiceTranscriptionService = new VoiceTranscriptionService({
        resourcesRoot: app.isPackaged ? join(process.resourcesPath, "whisper") : resolve(".openbot-build/whisper"),
        modelPath: app.isPackaged
          ? join(app.getPath("userData"), "runtimes", "whisper", WHISPER_MODEL_NAME)
          : resolve(".openbot-build/whisper/model", WHISPER_MODEL_NAME),
        modelDownloadUrl: WHISPER_MODEL_URL,
      });
      voiceTranscriptionService.on("modelStatus", forwardVoiceModelStatus);
      const { autoUpdater } = electronUpdater;
      updateService = new UpdateService(autoUpdater, {
        currentVersion: app.getVersion(),
        enabled:
          app.isPackaged &&
          supportsInstalledUpdates(process.platform) &&
          existsSync(join(process.resourcesPath, "app-update.yml")),
        beforeInstall: prepareForShutdown,
        platform: process.platform,
        nativeUpdater: nativeAutoUpdater,
        logDirectory: join(app.getPath("userData"), "logs", "update"),
        shipItDirectory: join(homedir(), "Library", "Caches", "app.openbot.desktop.ShipIt"),
      });
      service.on("event", (event) => forwardAgentEvent("local", event));
      sidebarLayoutStore.on("changed", (layout) =>
        forwardAgentEvent("local", { type: "sidebar-layout-changed", layout }),
      );
      host.on("changed", forwardHostStatus);
      host.on("presence", (snapshot) => forwardTeamPresence("local", snapshot));
      host.on("directMessage", (event) => forwardDirectMessage("local", event));
      host.on("directTyping", (event) => forwardDirectTyping("local", event));
      remoteDesktop.on("changed", forwardRemoteDesktopSessions);
      remoteServers.on("changed", forwardServers);
      remoteServers.on("agent", (serverId, event) => {
        forwardAgentEvent(serverId, event);
      });
      remoteServers.on("presence", forwardTeamPresence);
      remoteServers.on("directMessage", forwardDirectMessage);
      remoteServers.on("directTyping", forwardDirectTyping);
      updateService.on("status", forwardUpdateStatus);
      updateService.start();
      const agentInitialization = new AgentInitializationGate(() => service.initialize());
      registerIpcHandlers(
        service,
        providerRuntimeManager,
        mailboxStore,
        browserHost,
        updateService,
        setupFile,
        analyticsPreferenceFile,
        () => agentInitialization.start(),
        sidebarLayoutStore,
        host,
        remoteDesktop,
        remoteServers,
        centralAuthManager,
        skillMarketplace,
        agentMarketplace,
        voiceTranscriptionService,
      );
      configureApplicationMenu(service, updateService);
      await loadRenderer(mainWindow);
      const teamIdentity = teamStore.getIdentity();
      if (
        !developmentRemoteRole &&
        shouldAutoStartHost({
          configured: Boolean(teamIdentity),
          enabledOnLaunch: teamIdentity?.enabledOnLaunch ?? false,
        })
      ) {
        void centralAuthInitialization
          .then(() => host.start())
          .catch((error) => console.error("Unable to republish this OpenBot:", error));
      }
      void agentInitialization.start().catch((error) => {
        console.error("Unable to initialize the local agent backend:", error);
      });

      app.on("activate", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          return;
        }
        mainWindow = createWindow();
        void loadRenderer(mainWindow);
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("OpenBot failed to start:", error);
      dialog.showErrorBox(
        "OpenBot couldn’t start",
        `${message}\n\nYour local data was not reset or overwritten. See the troubleshooting guide for recovery steps.`,
      );
      app.quit();
    });
}

const DEVELOPMENT_REMOTE_CONNECTION_FILE = "openbot-dev-remote-connection-v1.json";
const developmentRemoteServerConnectionSchema: z.ZodType<DevelopmentRemoteServerConnection> = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1),
  apiUrl: z.string().min(1),
  fingerprint: z.string().min(1),
  publicKey: z.string().min(1),
  username: z.string().min(1),
  sessionToken: z.string().min(1),
});

function developmentRemoteConnectionPath(): string {
  return join(tmpdir(), DEVELOPMENT_REMOTE_CONNECTION_FILE);
}

async function ensureDevelopmentAccount(manager: CentralAuthManager, email: string) {
  const initialized = await manager.initialize();
  if (initialized.status === "signed_in" && initialized.user.email === email) return initialized.user;
  if (initialized.status === "signed_in") await manager.logout();
  const challenge = await manager.requestEmailCode(email);
  if (challenge.status !== "code_sent" || !challenge.developmentCode) {
    throw new Error("The local account API did not return a development sign-in code.");
  }
  const verified = await manager.verifyEmailCode(challenge.challengeId, challenge.developmentCode);
  if (verified.status !== "signed_in") throw new Error("The local development account could not sign in.");
  return verified.user;
}

async function writeDevelopmentRemoteConnection(connection: DevelopmentRemoteServerConnection): Promise<void> {
  await writeFile(developmentRemoteConnectionPath(), `${JSON.stringify(connection)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function connectDevelopmentRemoteServer(manager: RemoteServerManager): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = new Error("The local development host did not start.");
  while (Date.now() < deadline) {
    try {
      const connection = developmentRemoteServerConnectionSchema.parse(
        JSON.parse(await readFile(developmentRemoteConnectionPath(), "utf8")),
      );
      await manager.connectDevelopmentServer(connection);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError;
}

function readComputerUsePrerequisites(): {
  screenRecording: boolean;
  accessibility: boolean;
} {
  if (process.platform !== "darwin") {
    return { screenRecording: false, accessibility: false };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function readMacPermissions(): MacPermissionsState {
  if (process.platform !== "darwin") {
    return { screenRecording: "unknown", accessibility: "unknown" };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined",
  };
}

async function requestMacPermission(permission: MacPermissionId): Promise<MacPermissionsState> {
  if (process.platform !== "darwin") return readMacPermissions();
  if (permission === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return readMacPermissions();
  }

  const state = systemPreferences.getMediaAccessStatus("screen");
  if (state === "not-determined") {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  } else if (state === "denied" || state === "unknown") {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
  return readMacPermissions();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (systemSessionEnding) {
    updateService?.stop();
    void providerRuntimeManager?.stop();
    return;
  }
  if (shutdownStarted) return;
  event.preventDefault();
  void prepareForShutdown().finally(() => app.quit());
});

async function prepareForShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;
  updateService?.stop();
  await (providerRuntimeManager?.stop() ?? Promise.resolve());
  remoteServerManager?.stop();
  voiceTranscriptionService?.shutdown();
  await (remoteDesktopManager?.stop() ?? Promise.resolve());
  await (hostService?.shutdown() ?? Promise.resolve());
  await (browserHost?.destroy() ?? Promise.resolve());
  await (agentService?.stop() ?? Promise.resolve());
}

function configureRendererPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    canCheckRendererPermission(permission, requestingOrigin, details),
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = ("mediaTypes" in details ? details.mediaTypes : undefined) ?? [];
    callback(canRequestRendererPermission(permission, webContents.getURL(), { mediaTypes }));
  });
}

function routeUpdateBot(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: UpdateBotInput,
) {
  return serverId === "local"
    ? service.updateBot(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}`,
        {
          method: "PATCH",
          body: input,
        },
        serverId,
        decodeBotSummary,
      );
}

async function routeDeleteBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<void> {
  if (serverId === "local") {
    await service.deleteBot(botId);
    await sidebarLayout.removeAgent(botId);
    return;
  }
  await remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}`, { method: "DELETE" }, serverId, decodeVoid);
}

function routeReadConversation(host: HostService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? host.readAgentConversation(botId)
    : remoteServers.readAgentConversation(botId, serverId);
}

function routeSendMessage(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: SendMessageInput,
) {
  return serverId === "local"
    ? service.sendMessage(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}/messages`,
        {
          method: "POST",
          body: input,
        },
        serverId,
        decodeQueuedMessageReceipt,
      );
}

function routeListQueue(service: AgentService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? service.listQueue(botId)
    : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/queue`, {}, serverId, decodeQueueSnapshot);
}

async function uploadRemotePaths(remoteServers: RemoteServerManager, serverId: string, paths: string[]) {
  if (paths.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  for (const path of paths) assertSupportedAttachmentName(basename(path));
  const files = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  );
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (total > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return Promise.all(
    files.map((file) => remoteServers.uploadAttachment(file.name, mimeTypeForName(file.name), file.bytes, serverId)),
  );
}

async function uploadRemoteImports(
  remoteServers: RemoteServerManager,
  serverId: string,
  input: ImportAttachmentsInput,
) {
  if (input.paths.length + input.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  const pathFiles = await Promise.all(
    input.paths.map(async (path) => ({
      name: basename(path),
      mimeType: mimeTypeForName(path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  );
  const files = [
    ...pathFiles,
    ...input.data.map((item) => ({
      name: basename(item.name),
      mimeType: item.mimeType,
      bytes: item.bytes,
    })),
  ];
  for (const file of files) assertSupportedAttachmentName(file.name);
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return Promise.all(
    files.map((file) => remoteServers.uploadAttachment(file.name, file.mimeType, file.bytes, serverId)),
  );
}

function assertSupportedAttachmentName(name: string): void {
  if (isSupportedAttachmentName(name)) return;
  throw new Error(`${name} is not supported. Attach ${SUPPORTED_ATTACHMENT_DESCRIPTION}.`);
}

function configureAttachmentProtocol(mailbox: MailboxStore, agents: AgentService): void {
  session.defaultSession.protocol.handle("openbot-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.split("/").filter(Boolean).at(-1);
      const attachment = id ? await mailbox.resolveAttachment(id) : null;
      if (!attachment) return new Response("Not found", { status: 404 });
      return new Response(await readFile(attachment.path), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const attachmentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      if (!remoteServerManager || !serverId || !attachmentId) {
        return new Response("Not found", { status: 404 });
      }
      const attachment = await remoteServerManager.downloadAttachment(attachmentId, serverId);
      return new Response(Buffer.from(attachment.bytes), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "agent") return new Response("Not found", { status: 404 });
      const botId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      const avatar = botId ? agents.resolveAvatar(botId) : null;
      if (!avatar || avatar.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(avatar.path), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const botId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      if (!remoteServerManager || !serverId || !botId) {
        return new Response("Not found", { status: 404 });
      }
      const version = url.searchParams.get("v");
      if (!version) return new Response("Not found", { status: 404 });
      const avatar = await remoteServerManager.downloadAgentAvatar(botId, serverId, version);
      return new Response(Buffer.from(avatar.bytes), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function configureServerLogoProtocols(teamStore: TeamStore): void {
  session.defaultSession.protocol.handle("openbot-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const logo = teamStore.resolveLogo();
      if (url.hostname !== "local" || !logo || logo.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(logo.path), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const version = url.searchParams.get("v");
      if (!remoteServerManager || !serverId || !version) return new Response("Not found", { status: 404 });
      const logo = await remoteServerManager.downloadServerLogo(serverId, version);
      return new Response(Buffer.from(logo.bytes), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function configureApplicationProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  session.defaultSession.protocol.handle("openbot-app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const filePath = resolve(rendererRoot, `.${pathname}`);
      const candidate = relative(rendererRoot, filePath);
      if (candidate.startsWith("..") || isAbsolute(candidate)) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(filePath), {
        headers: {
          "Content-Type": applicationContentType(filePath),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function applicationContentType(
  path: string,
):
  | "text/html; charset=utf-8"
  | "text/javascript; charset=utf-8"
  | "text/css; charset=utf-8"
  | "image/svg+xml"
  | "image/png"
  | "font/woff2"
  | "application/octet-stream" {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
