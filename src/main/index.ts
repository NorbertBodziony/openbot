import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  Notification,
  type OpenDialogOptions,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron";
import electronUpdater from "electron-updater";
import { AgentService } from "../backend/agent-service";
import { BotStore } from "../backend/bot-store";
import { BrowserHost } from "../backend/browser-host";
import { MailboxStore } from "../backend/mailbox-store";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "../shared/input-limits";
import {
  type AgentEvent,
  type AgentIpcRequest,
  type AgentProviderId,
  type AppInfo,
  type AppSetupState,
  type BrowserBounds,
  type BrowserOpenInput,
  type BrowserVisibilityInput,
  type CancelQueuedMessageInput,
  type CentralAuthState,
  type ConfigureHostInput,
  type CreateTeamInviteInput,
  type ExternalDestination,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  IPC_CHANNELS,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type JoinServerInput,
  type LoginServerInput,
  type MacPermissionId,
  type MacPermissionsState,
  type OpenAttachmentInput,
  type RemoteMacConnectInput,
  type RespondToPromptInput,
  type SendMessageInput,
  type SetQueuePausedInput,
  type UpdateBotInput,
  type UpdateTeamMemberInput,
} from "../shared/ipc";
import { AgentInitializationGate } from "./agent-initialization";
import { notificationForAgentEvent } from "./agent-notifications";
import { CentralAuthManager, readCentralAuthApiUrl } from "./central-auth-manager";
import {
  developmentUserDataName,
  readDevelopmentProfile,
  shouldAutoStartHost,
} from "./development-profile";
import { HostService } from "./host-service";
import { exportDiagnostics, exportOpenBotData } from "./maintenance-service";
import { RemoteMacManager } from "./remote-mac";
import { RemoteServerManager } from "./remote-server-manager";
import { readSetupState, writeSetupState } from "./setup-store";
import { TeamStore } from "./team-store";
import { handleTrusted } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";
import { supportsInstalledUpdates, UpdateService } from "./update-service";

if (!app.isPackaged) {
  const profile = readDevelopmentProfile(process.env.OPENBOT_DEV_PROFILE);
  app.setPath("userData", join(app.getPath("appData"), developmentUserDataName(profile)));
}
app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId("app.openbot.desktop");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
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
]);

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let agentService: AgentService | null = null;
let mailboxStore: MailboxStore | null = null;
let updateService: UpdateService | null = null;
let hostService: HostService | null = null;
let remoteMacManager: RemoteMacManager | null = null;
let remoteServerManager: RemoteServerManager | null = null;
let centralAuthManager: CentralAuthManager | null = null;
let isQuitting = false;
let shutdownStarted = false;
let pendingInviteUrl: string | null = null;
let pendingAddressUpdateUrl: string | null = null;

const SETUP_FILE = "openbot-setup-v2.json";
const BROWSER_STATE_FILE = "openbot-browser-state-v1.json";
const TEAM_FILE = "openbot-team-server-v1.json";
const REMOTE_SERVERS_FILE = "openbot-remote-servers-v1.json";
const CENTRAL_AUTH_FILE = "openbot-central-auth-v1.bin";

const EXTERNAL_DESTINATIONS: Record<ExternalDestination, string> = {
  "agent-setup": "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  feedback: "https://x.com/intent/post?text=Feedback%20for%20OpenBot%20%40norbertbodziony%3A%20",
  message: "https://x.com/norbertbodziony",
};

function configureContentSecurityPolicy(): void {
  const developmentSources = app.isPackaged ? "" : " http://localhost:* ws://localhost:*";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: openbot-attachment: openbot-remote-attachment: https:",
    "font-src 'self' data:",
    `connect-src 'self'${developmentSources}`,
    "object-src 'none'",
    "frame-src 'self' openbot-attachment: openbot-remote-attachment:",
    "base-uri 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
  mailbox: MailboxStore,
  browser: BrowserHost,
  updater: UpdateService,
  setupFile: string,
  initializeAgent: () => Promise<void>,
  host: HostService,
  remoteMac: RemoteMacManager,
  remoteServers: RemoteServerManager,
  centralAuth: CentralAuthManager,
): void {
  handleTrusted(IPC_CHANNELS.getAppInfo, (): AppInfo => {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      throw new Error(`Unsupported desktop platform: ${platform}`);
    }
    return { name: app.getName(), version: app.getVersion(), platform };
  });
  handleTrusted(IPC_CHANNELS.getSetupState, () => readSetupState(setupFile));
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
    if (destination !== "agent-setup" && destination !== "feedback" && destination !== "message") {
      throw new Error("Unknown external destination.");
    }
    return shell.openExternal(EXTERNAL_DESTINATIONS[destination]);
  });
  handleTrusted(IPC_CHANNELS.openUrl, (value: unknown) => {
    const url = new URL(requireString(value, "URL", INPUT_LIMITS.browserUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) links can open in the external browser.");
    }
    return shell.openExternal(url.toString());
  });
  handleTrusted(IPC_CHANNELS.authGetState, () => centralAuth.getState());
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
  handleTrusted(IPC_CHANNELS.authLogout, () => centralAuth.logout());
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

  handleTrusted(IPC_CHANNELS.serversList, () => remoteServers.list());
  handleTrusted(IPC_CHANNELS.serversSelect, (serverId: unknown) =>
    remoteServers.select(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversJoin, (input: unknown) =>
    remoteServers.join(parseJoinServer(input)),
  );
  handleTrusted(IPC_CHANNELS.serversLogin, (input: unknown) =>
    remoteServers.login(parseLoginServer(input)),
  );
  handleTrusted(IPC_CHANNELS.serversUpdateAddress, (updateUrl: unknown) =>
    remoteServers.updateAddress(requireString(updateUrl, "updateUrl", INPUT_LIMITS.inviteUrl)),
  );
  handleTrusted(IPC_CHANNELS.serversRemove, (serverId: unknown) =>
    remoteServers.remove(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.hostGetStatus, () => host.getStatus());
  handleTrusted(IPC_CHANNELS.hostConfigure, (input: unknown) =>
    host.configure(parseHostConfig(input)),
  );
  handleTrusted(IPC_CHANNELS.hostStart, () => host.start());
  handleTrusted(IPC_CHANNELS.hostStop, () => host.stop());
  handleTrusted(IPC_CHANNELS.hostListMembers, () => host.listMembers());
  handleTrusted(IPC_CHANNELS.hostUpdateMember, (input: unknown) =>
    host.updateMember(parseUpdateTeamMember(input)),
  );
  handleTrusted(IPC_CHANNELS.hostListSessions, () => host.listSessions());
  handleTrusted(IPC_CHANNELS.hostRevokeSession, (sessionId: unknown) =>
    host.revokeSession(requireString(sessionId, "sessionId")),
  );
  handleTrusted(IPC_CHANNELS.hostListInvites, () => host.listInvites());
  handleTrusted(IPC_CHANNELS.hostRevokeInvite, (inviteId: unknown) =>
    host.revokeInvite(requireString(inviteId, "inviteId")),
  );
  handleTrusted(IPC_CHANNELS.hostCreateInvite, (input: unknown) =>
    host.createInvite(parseCreateTeamInvite(input)),
  );
  handleTrusted(IPC_CHANNELS.hostCreateAddressUpdate, () => host.createAddressUpdate());
  handleTrusted(IPC_CHANNELS.remoteMacList, () => remoteMac.list());
  handleTrusted(IPC_CHANNELS.remoteMacConnect, (input: unknown) =>
    remoteMac.connect(parseRemoteMacConnect(input)),
  );
  handleTrusted(IPC_CHANNELS.remoteMacDisconnect, (sessionId: unknown) =>
    remoteMac.disconnect(requireString(sessionId, "sessionId")),
  );

  handleTrusted(IPC_CHANNELS.agentGetStatus, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getStatus()
      : remoteServers.request("/v1/agents/status", {}, serverId);
  });
  handleTrusted(IPC_CHANNELS.agentGetUsage, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getUsage()
      : remoteServers.request("/v1/agents/usage", {}, serverId);
  });
  handleTrusted(IPC_CHANNELS.agentListModels, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listModels()
      : remoteServers.request("/v1/agents/models", {}, serverId);
  });
  handleTrusted(IPC_CHANNELS.agentListBots, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listBots()
      : remoteServers.request("/v1/agents", {}, serverId);
  });
  handleTrusted(IPC_CHANNELS.agentCreateBot, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.createBot()
      : remoteServers.request("/v1/agents", { method: "POST", body: {} }, serverId);
  });
  handleTrusted(IPC_CHANNELS.agentUpdateBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeUpdateBot(service, remoteServers, scoped.serverId, parseUpdateBot(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentDeleteBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeDeleteBot(
      service,
      remoteServers,
      scoped.serverId,
      requireString(scoped.payload, "botId"),
    );
  });
  handleTrusted(IPC_CHANNELS.agentReadConversation, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeReadConversation(
      service,
      remoteServers,
      scoped.serverId,
      requireString(scoped.payload, "botId"),
    );
  });
  handleTrusted(IPC_CHANNELS.agentSendMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeSendMessage(
      service,
      remoteServers,
      scoped.serverId,
      parseSendMessage(scoped.payload),
    );
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
        );
  });
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, async (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    const options: OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
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
        );
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenAttachment(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadAttachment(
        parsed.attachmentId,
        scoped.serverId,
      );
      const cacheRoot = join(app.getPath("userData"), "remote-attachments");
      await mkdir(cacheRoot, { recursive: true });
      const safeName = `${parsed.attachmentId}-${basename(downloaded.name)}`;
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
    if (parsed.action === "reveal") {
      shell.showItemInFolder(attachment.path);
      return;
    }
    const error = await shell.openPath(attachment.path);
    if (error) throw new Error(error);
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeListQueue(
      service,
      remoteServers,
      scoped.serverId,
      requireString(scoped.payload, "botId"),
    );
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
        );
  });
  handleTrusted(IPC_CHANNELS.agentSetQueuePaused, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSetQueuePaused(scoped.payload);
    return scoped.serverId === "local"
      ? service.setQueuePaused(parsed.botId, parsed.paused)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/pause`,
          {
            method: "POST",
            body: { paused: parsed.paused },
          },
          scoped.serverId,
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
        );
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parsePromptResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToPrompt(parsed)
      : remoteServers.request(
          "/v1/prompts/respond",
          { method: "POST", body: parsed },
          scoped.serverId,
        );
  });

  handleTrusted(IPC_CHANNELS.browserOpen, (input: unknown) => {
    const parsed = parseBrowserOpen(input);
    return remoteServers.activeServerId === "local"
      ? browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null)
      : remoteServers.request("/v1/browser/open", { method: "POST", body: parsed });
  });
  handleTrusted(IPC_CHANNELS.browserActivate, (tabId: unknown) =>
    remoteServers.activeServerId === "local"
      ? browser.activate(requireString(tabId, "tabId"))
      : remoteServers.request("/v1/browser/activate", {
          method: "POST",
          body: { tabId: requireString(tabId, "tabId") },
        }),
  );
  handleTrusted(IPC_CHANNELS.browserClose, (tabId: unknown) =>
    remoteServers.activeServerId === "local"
      ? browser.close(requireString(tabId, "tabId"))
      : remoteServers.request("/v1/browser/close", {
          method: "POST",
          body: { tabId: requireString(tabId, "tabId") },
        }),
  );
  handleTrusted(IPC_CHANNELS.browserListTabs, () =>
    remoteServers.activeServerId === "local"
      ? browser.listTabs()
      : remoteServers.request("/v1/browser/tabs"),
  );
  handleTrusted(IPC_CHANNELS.browserGetControlState, () =>
    remoteServers.activeServerId === "local"
      ? browser.getControlState()
      : remoteServers.request("/v1/browser/control"),
  );
  handleTrusted(IPC_CHANNELS.browserSetVisible, async (input: unknown) => {
    const parsed = parseVisibility(input);
    if (remoteServers.activeServerId === "local") await browser.setVisible(parsed);
    else await remoteServers.request("/v1/browser/visible", { method: "POST", body: parsed });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d0e",
    title: "OpenBot",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 13, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });

  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl
    ? window.loadURL(developmentUrl)
    : window.loadURL("openbot-app://app/index.html");
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

function forwardUpdateStatus(status: import("../shared/ipc").UpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.updateEvent, status);
}

function forwardHostStatus(status: import("../shared/ipc").HostStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.hostEvent, status);
}

function forwardRemoteMacSessions(sessions: import("../shared/ipc").RemoteMacSession[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.remoteMacEvent, sessions);
}

function forwardServers(servers: import("../shared/ipc").ServerSummary[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.serversEvent, servers);
}

function forwardCentralAuth(state: CentralAuthState): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.authEvent, state);
}

function acceptInviteUrl(value: string): void {
  if (!value.startsWith("openbot://join?")) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC_CHANNELS.serversInvite, value);
  } else {
    pendingInviteUrl = value;
  }
}

function acceptAddressUpdateUrl(value: string): void {
  if (!value.startsWith("openbot://update?")) return;
  if (!remoteServerManager) {
    pendingAddressUpdateUrl = value;
    return;
  }
  void remoteServerManager.updateAddress(value).catch((error) => {
    const message = error instanceof Error ? error.message : "The server address was not updated.";
    dialog.showErrorBox("OpenBot server update failed", message);
  });
}

function acceptOpenbotUrl(value: string): void {
  if (value.startsWith("openbot://join?")) acceptInviteUrl(value);
  else if (value.startsWith("openbot://update?")) acceptAddressUpdateUrl(value);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  acceptOpenbotUrl(url);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find(
      (value) => value.startsWith("openbot://join?") || value.startsWith("openbot://update?"),
    );
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
      configureContentSecurityPolicy();
      mainWindow = createWindow();
      centralAuthManager = new CentralAuthManager({
        apiUrl: readCentralAuthApiUrl(process.env.OPENBOT_AUTH_API_URL),
        storagePath: join(app.getPath("userData"), CENTRAL_AUTH_FILE),
        encrypt: (value) => {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("macOS secure storage is unavailable.");
          }
          return safeStorage.encryptString(value);
        },
        decrypt: (value) => safeStorage.decryptString(value),
      });
      centralAuthManager.on("changed", forwardCentralAuth);
      await centralAuthManager.initialize();
      const store = new BotStore(app.getPath("userData"), homedir());
      await store.initialize();
      mailboxStore = new MailboxStore(app.getPath("userData"), store.sharedRoot, store.database);
      await mailboxStore.initialize();
      configureApplicationProtocol();
      configureAttachmentProtocol(mailboxStore);
      browserHost = new BrowserHost(
        mainWindow,
        store.downloadsRoot,
        join(app.getPath("userData"), BROWSER_STATE_FILE),
      );
      await browserHost.restore();
      const setupFile = join(app.getPath("userData"), SETUP_FILE);
      const setupState = await readSetupState(setupFile);
      agentService = new AgentService(
        store,
        mailboxStore,
        browserHost,
        readComputerUsePrerequisites,
        30_000,
        setupState.preferredProvider ?? "codex",
      );
      const service = agentService;
      const teamStore = new TeamStore(join(app.getPath("userData"), TEAM_FILE));
      await teamStore.initialize();
      hostService = new HostService({
        store: teamStore,
        agents: service,
        mailbox: mailboxStore,
        browser: browserHost,
        logDirectory: join(app.getPath("userData"), "logs", "remote"),
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
        provisionTeamTunnel: (input) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.provisionTeamTunnel(input);
        },
      });
      remoteMacManager = new RemoteMacManager({
        openExternal: (url) => shell.openExternal(url),
        logDirectory: join(app.getPath("userData"), "logs", "remote"),
      });
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
      );
      await remoteServerManager.initialize();
      if (pendingAddressUpdateUrl) {
        const updateUrl = pendingAddressUpdateUrl;
        pendingAddressUpdateUrl = null;
        void remoteServerManager.updateAddress(updateUrl).catch((error) => {
          const message =
            error instanceof Error ? error.message : "The server address was not updated.";
          dialog.showErrorBox("OpenBot server update failed", message);
        });
      }
      const host = hostService;
      const remoteMac = remoteMacManager;
      const remoteServers = remoteServerManager;
      const { autoUpdater } = electronUpdater;
      updateService = new UpdateService(autoUpdater, {
        currentVersion: app.getVersion(),
        enabled:
          app.isPackaged &&
          supportsInstalledUpdates(process.platform) &&
          existsSync(join(process.resourcesPath, "app-update.yml")),
        beforeInstall: prepareForShutdown,
      });
      service.on("event", (event) => forwardAgentEvent("local", event));
      host.on("changed", forwardHostStatus);
      remoteMac.on("changed", forwardRemoteMacSessions);
      remoteServers.on("changed", forwardServers);
      remoteServers.on("agent", (serverId, event) => {
        forwardAgentEvent(serverId, event);
      });
      updateService.on("status", forwardUpdateStatus);
      updateService.start();
      const agentInitialization = new AgentInitializationGate(() => service.initialize());
      registerIpcHandlers(
        service,
        mailboxStore,
        browserHost,
        updateService,
        setupFile,
        () => agentInitialization.start(),
        host,
        remoteMac,
        remoteServers,
        centralAuthManager,
      );
      configureApplicationMenu(service, updateService);
      await loadRenderer(mainWindow);
      if (pendingInviteUrl) {
        mainWindow.webContents.send(IPC_CHANNELS.serversInvite, pendingInviteUrl);
        pendingInviteUrl = null;
      }
      const teamIdentity = teamStore.getIdentity();
      const forcedHostStart = !app.isPackaged && process.env.OPENBOT_DEV_HOST_AUTO_START === "1";
      if (
        shouldAutoStartHost({
          configured: Boolean(teamIdentity),
          enabledOnLaunch: teamIdentity?.enabledOnLaunch ?? false,
          forcedByDevelopmentScript: forcedHostStart,
        })
      ) {
        void host
          .start()
          .catch((error) => console.error("Unable to restart the team server:", error));
      } else if (forcedHostStart && !teamIdentity) {
        console.info("Host profile is ready. Configure the team server in the Host panel first.");
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
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
      ? "granted"
      : "not-determined",
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
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  return readMacPermissions();
}

function parseProvider(input: unknown): AgentProviderId {
  if (!input || typeof input !== "object") throw new Error("Setup input is required.");
  const provider = Reflect.get(input, "preferredProvider");
  if (provider !== "codex" && provider !== "claude") throw new Error("Unknown provider.");
  return provider;
}

function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownStarted) return;
  event.preventDefault();
  void prepareForShutdown().finally(() => app.quit());
});

async function prepareForShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;
  updateService?.stop();
  remoteServerManager?.stop();
  await (remoteMacManager?.stop() ?? Promise.resolve());
  await (hostService?.shutdown() ?? Promise.resolve());
  await (browserHost?.destroy() ?? Promise.resolve());
  await (agentService?.stop() ?? Promise.resolve());
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number = INPUT_LIMITS.identifier,
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > maxLength) throw new Error(`${field} is too long.`);
  return value;
}

function parseHostConfig(value: unknown): ConfigureHostInput {
  if (!isObject(value)) throw new Error("Host configuration is required.");
  return {
    serverName: requireString(value.serverName, "serverName", INPUT_LIMITS.serverName),
  };
}

function parseJoinServer(value: unknown): JoinServerInput {
  if (!isObject(value)) throw new Error("Invitation details are required.");
  return {
    inviteUrl: requireString(value.inviteUrl, "inviteUrl", INPUT_LIMITS.inviteUrl),
  };
}

function parseLoginServer(value: unknown): LoginServerInput {
  if (!isObject(value)) throw new Error("Login details are required.");
  return {
    serverId: requireString(value.serverId, "serverId"),
  };
}

function parseCreateTeamInvite(value: unknown): CreateTeamInviteInput {
  if (!isObject(value)) throw new Error("Invitation details are required.");
  if (value.role !== "admin" && value.role !== "member") {
    throw new Error("Unknown team role.");
  }
  if (value.email !== undefined && typeof value.email !== "string") {
    throw new Error("Invalid invitation email.");
  }
  if (typeof value.email === "string" && value.email.length > INPUT_LIMITS.email) {
    throw new Error("Invitation email is too long.");
  }
  return {
    role: value.role,
    ...(value.email?.trim() ? { email: value.email.trim() } : {}),
  };
}

function parseRemoteMacConnect(value: unknown): RemoteMacConnectInput {
  if (!isObject(value)) throw new Error("Remote Mac details are required.");
  const serverId = value.serverId;
  if (serverId !== undefined && serverId !== null && typeof serverId !== "string") {
    throw new Error("Invalid serverId.");
  }
  return {
    hostname: requireString(value.hostname, "hostname", INPUT_LIMITS.hostname),
    serverId: serverId ?? null,
  };
}

function parseAgentRequest(value: unknown): AgentIpcRequest {
  if (!isObject(value)) throw new Error("Invalid agent request.");
  return {
    serverId: requireString(value.serverId, "serverId"),
    payload: value.payload,
  };
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
      );
}

function routeDeleteBot(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
) {
  return serverId === "local"
    ? service.deleteBot(botId)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(botId)}`,
        { method: "DELETE" },
        serverId,
      );
}

function routeReadConversation(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
) {
  return serverId === "local"
    ? service.readConversation(botId)
    : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/conversation`, {}, serverId);
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
      );
}

function routeListQueue(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
) {
  return serverId === "local"
    ? service.listQueue(botId)
    : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/queue`, {}, serverId);
}

async function uploadRemotePaths(
  remoteServers: RemoteServerManager,
  serverId: string,
  paths: string[],
) {
  if (paths.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
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
    files.map((file) =>
      remoteServers.uploadAttachment(file.name, mimeTypeForName(file.name), file.bytes, serverId),
    ),
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
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return Promise.all(
    files.map((file) =>
      remoteServers.uploadAttachment(file.name, file.mimeType, file.bytes, serverId),
    ),
  );
}

function mimeTypeForName(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function parseSendMessage(value: unknown): SendMessageInput {
  if (!isObject(value)) throw new Error("Invalid send message request.");
  const attachmentDraftIds = value.attachmentDraftIds ?? [];
  if (
    !Array.isArray(attachmentDraftIds) ||
    attachmentDraftIds.length > INPUT_LIMITS.attachments ||
    !attachmentDraftIds.every(
      (item) => typeof item === "string" && item.length <= INPUT_LIMITS.identifier,
    )
  ) {
    throw new Error("Invalid attachment drafts.");
  }
  if (typeof value.text !== "string") throw new Error("text is required.");
  if (value.text.length > INPUT_LIMITS.messageText) throw new Error("Message is too long.");
  if (!value.text.trim() && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  const replyToMessageId = value.replyToMessageId ?? null;
  if (
    replyToMessageId !== null &&
    (typeof replyToMessageId !== "string" || replyToMessageId.length > INPUT_LIMITS.identifier)
  ) {
    throw new Error("Invalid reply target.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    text: value.text,
    attachmentDraftIds,
    replyToMessageId: replyToMessageId?.trim() || null,
  };
}

function parseMessageReaction(value: unknown) {
  if (!isObject(value)) throw new Error("Invalid message reaction request.");
  const emoji = value.emoji;
  if (emoji !== null && !isMessageReaction(emoji)) {
    throw new Error("Invalid message reaction.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    messageId: requireString(value.messageId, "messageId"),
    emoji,
  };
}

function parseUpdateBot(value: unknown): UpdateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot update request.");
  const result: UpdateBotInput = { botId: requireString(value.botId, "botId") };
  const limits = {
    name: INPUT_LIMITS.agentName,
    role: INPUT_LIMITS.agentTitle,
    description: INPUT_LIMITS.agentDescription,
  } as const;
  for (const field of ["name", "role", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid ${field}.`);
    }
    if (typeof value[field] === "string") {
      if (value[field].length > limits[field]) throw new Error(`${field} is too long.`);
      result[field] = value[field];
    }
  }
  if (value.notifications !== undefined) {
    if (typeof value.notifications !== "boolean") throw new Error("Invalid notifications value.");
    result.notifications = value.notifications;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("Invalid agent model.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) throw new Error("Invalid reasoning effort.");
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.avatarSeed !== undefined) {
    if (!isAvatarSeed(value.avatarSeed)) throw new Error("Invalid avatar seed.");
    result.avatarSeed = value.avatarSeed;
  }
  if (value.avatarHue !== undefined) {
    if (value.avatarHue !== null && !isAvatarHue(value.avatarHue)) {
      throw new Error("Invalid avatar hue.");
    }
    result.avatarHue = value.avatarHue;
  }
  return result;
}

function parseImportAttachments(value: unknown): ImportAttachmentsInput {
  if (!isObject(value) || !Array.isArray(value.paths) || !Array.isArray(value.data)) {
    throw new Error("Invalid attachment import.");
  }
  if (value.paths.length + value.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  if (
    !value.paths.every(
      (path) => typeof path === "string" && path.length > 0 && path.length <= INPUT_LIMITS.path,
    )
  ) {
    throw new Error("Invalid attachment path.");
  }
  const data = value.data.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      item.name.length > INPUT_LIMITS.attachmentName ||
      typeof item.mimeType !== "string" ||
      item.mimeType.length > INPUT_LIMITS.mimeType ||
      !(item.bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid attachment data.");
    }
    return { name: item.name, mimeType: item.mimeType, bytes: item.bytes };
  });
  return { paths: value.paths, data };
}

function parseOpenAttachment(value: unknown): OpenAttachmentInput {
  if (!isObject(value) || (value.action !== "open" && value.action !== "reveal")) {
    throw new Error("Invalid attachment action.");
  }
  return {
    attachmentId: requireString(value.attachmentId, "attachmentId"),
    action: value.action,
  };
}

function parseCancelQueuedMessage(value: unknown): CancelQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queue cancellation request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
  };
}

function parseSetQueuePaused(value: unknown): SetQueuePausedInput {
  if (!isObject(value) || typeof value.paused !== "boolean") {
    throw new Error("Invalid queue pause request.");
  }
  return { botId: requireString(value.botId, "botId"), paused: value.paused };
}

function parseUpdateTeamMember(value: unknown): UpdateTeamMemberInput {
  if (!isObject(value)) throw new Error("Invalid team member update.");
  const role = value.role;
  const disabled = value.disabled;
  if (role !== undefined && role !== "admin" && role !== "member") {
    throw new Error("Invalid team member role.");
  }
  if (disabled !== undefined && typeof disabled !== "boolean") {
    throw new Error("Invalid team member state.");
  }
  return {
    memberId: requireString(value.memberId, "memberId"),
    ...(role ? { role } : {}),
    ...(disabled === undefined ? {} : { disabled }),
  };
}

function configureAttachmentProtocol(mailbox: MailboxStore): void {
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

function applicationContentType(path: string): string {
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

function parseInterrupt(value: unknown): InterruptTurnInput {
  if (!isObject(value)) throw new Error("Invalid interrupt request.");
  return {
    botId: requireString(value.botId, "botId"),
    turnId: requireString(value.turnId, "turnId"),
  };
}

function parsePromptResponse(value: unknown): RespondToPromptInput {
  if (
    !isObject(value) ||
    (typeof value.requestId !== "string" && typeof value.requestId !== "number")
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (
    (typeof value.requestId === "string" &&
      (value.requestId.length === 0 || value.requestId.length > INPUT_LIMITS.identifier)) ||
    (typeof value.requestId === "number" && !Number.isSafeInteger(value.requestId))
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (!isObject(value.answers)) throw new Error("Prompt answers are required.");
  const entries = Object.entries(value.answers);
  if (entries.length > INPUT_LIMITS.promptQuestions) throw new Error("Too many prompt answers.");
  const answers: Record<string, string[]> = {};
  for (const [key, answer] of entries) {
    if (
      key.length > INPUT_LIMITS.identifier ||
      !Array.isArray(answer) ||
      answer.length > INPUT_LIMITS.promptAnswersPerQuestion ||
      !answer.every(
        (item) => typeof item === "string" && item.length <= INPUT_LIMITS.promptAnswerText,
      )
    ) {
      throw new Error("Invalid prompt answer.");
    }
    answers[key] = answer;
  }
  return { requestId: value.requestId, answers };
}

function parseBrowserOpen(value: unknown): BrowserOpenInput {
  if (!isObject(value)) throw new Error("Invalid browser open request.");
  return {
    url: requireString(value.url, "url", INPUT_LIMITS.browserUrl),
    ownerThreadId:
      value.ownerThreadId === null || value.ownerThreadId === undefined
        ? null
        : requireString(value.ownerThreadId, "ownerThreadId"),
    ownerBotId:
      value.ownerBotId === null || value.ownerBotId === undefined
        ? null
        : requireString(value.ownerBotId, "ownerBotId"),
  };
}

function parseVisibility(value: unknown): BrowserVisibilityInput {
  if (!isObject(value) || typeof value.visible !== "boolean") {
    throw new Error("Invalid browser visibility request.");
  }
  return {
    visible: value.visible,
    bounds: value.bounds === undefined ? undefined : parseBounds(value.bounds),
  };
}

function parseBounds(value: unknown): BrowserBounds {
  if (!isObject(value)) throw new Error("Invalid browser bounds.");
  const fields = ["x", "y", "width", "height"] as const;
  for (const field of fields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      throw new Error(`Invalid browser bound: ${field}.`);
    }
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
